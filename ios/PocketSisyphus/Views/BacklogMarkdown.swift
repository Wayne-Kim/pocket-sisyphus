import SwiftUI

/// 경량 마크다운 렌더 — 브리프 problem/scope/spec 본문의 블록/인라인 렌더와 파서.
/// 원래 BacklogView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 색·문자열·레이아웃 그대로.
// MARK: - 경량 마크다운 렌더 (브리프 problem/scope/spec)

/// 브리프 본문의 한 블록 — 줄 단위로 갈라 블록 구조(헤더/리스트/코드펜스)는 직접 그리고,
/// 인라인(굵게/이탤릭/코드/링크)만 AttributedString(markdown:) 에 맡긴다.
enum MarkdownBlock {
    case heading(level: Int, inline: String)
    case bullet(indent: Int, inline: String)
    case ordered(marker: String, inline: String)
    case task(checked: Bool, inline: String)
    case code(String)
    case paragraph(String)
}

/// 에이전트가 «markdown 으로» 쓴 본문(##·- [ ]·**·백틱)을 블록으로 가른다. 코드펜스(```) 안은
/// 원문 그대로 보존하고, 빈 줄은 버린다(VStack 간격이 단락을 가른다). 블록 인식 실패분은
/// paragraph 로 떨어져 인라인 렌더(또는 원문)로 폴백한다 — 어느 경우에도 크래시는 없다.
func markdownBlocks(_ raw: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var codeLines: [String] = []
    var inCode = false
    for line in raw.components(separatedBy: .newlines) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") {
            if inCode {
                blocks.append(.code(codeLines.joined(separator: "\n")))
                codeLines.removeAll()
            }
            inCode.toggle()
            continue
        }
        if inCode { codeLines.append(line); continue }
        if trimmed.isEmpty { continue }
        if let h = markdownHeading(trimmed) {
            blocks.append(.heading(level: h.level, inline: h.text))
        } else if let t = markdownTask(trimmed) {
            blocks.append(.task(checked: t.checked, inline: t.text))
        } else if let b = markdownBullet(line) {
            blocks.append(.bullet(indent: b.indent, inline: b.text))
        } else if let o = markdownOrdered(trimmed) {
            blocks.append(.ordered(marker: o.marker, inline: o.text))
        } else {
            blocks.append(.paragraph(trimmed))
        }
    }
    // 닫히지 않은 코드펜스 — 모아둔 줄을 코드 블록으로 마무리(원문 손실 방지).
    if inCode, !codeLines.isEmpty {
        blocks.append(.code(codeLines.joined(separator: "\n")))
    }
    return blocks
}

func markdownHeading(_ s: String) -> (level: Int, text: String)? {
    guard s.hasPrefix("#") else { return nil }
    var level = 0
    var idx = s.startIndex
    while idx < s.endIndex, s[idx] == "#", level < 6 {
        level += 1
        idx = s.index(after: idx)
    }
    guard idx < s.endIndex, s[idx] == " " else { return nil }   // `#tag` (공백 없음)은 헤더 아님
    return (level, String(s[idx...]).trimmingCharacters(in: .whitespaces))
}

func markdownTask(_ s: String) -> (checked: Bool, text: String)? {
    for m in ["- ", "* ", "+ "] where s.hasPrefix(m) {
        let rest = s.dropFirst(m.count)
        if rest.hasPrefix("[ ]") {
            return (false, String(rest.dropFirst(3)).trimmingCharacters(in: .whitespaces))
        }
        if rest.hasPrefix("[x]") || rest.hasPrefix("[X]") {
            return (true, String(rest.dropFirst(3)).trimmingCharacters(in: .whitespaces))
        }
    }
    return nil
}

func markdownBullet(_ line: String) -> (indent: Int, text: String)? {
    let leading = line.prefix { $0 == " " }.count
    let s = line.trimmingCharacters(in: .whitespaces)
    for m in ["- ", "* ", "+ "] where s.hasPrefix(m) {
        return (indent: min(leading / 2, 3), text: String(s.dropFirst(m.count)))
    }
    return nil
}

func markdownOrdered(_ s: String) -> (marker: String, text: String)? {
    var i = s.startIndex
    var digits = ""
    while i < s.endIndex, s[i].isNumber { digits.append(s[i]); i = s.index(after: i) }
    guard !digits.isEmpty, i < s.endIndex, s[i] == "." || s[i] == ")" else { return nil }
    let after = s.index(after: i)
    guard after < s.endIndex, s[after] == " " else { return nil }
    return ("\(digits).", String(s[after...]).trimmingCharacters(in: .whitespaces))
}

/// 본문(problem/scope/spec) 마크다운 렌더. ##·- [ ]·**·백틱이 «서식» 으로 보이게 — 서식 기호가
/// 의미 앞을 가리지 않게 한다. 블록은 직접 그리고 인라인은 AttributedString(markdown:) 으로,
/// 파싱 실패 시 원문(verbatim) 폴백(크래시 금지). 시맨틱 폰트(.callout 등)를 유지해 Dynamic Type
/// 을 보존하고, 코드 스팬·코드 블록은 monospaced 로 둔다(근거 ref 의 .monospaced() 와 일관).
/// limit 이 있으면 앞 N 블록만 — 긴 spec 의 점진적 공개(접힘 미리보기)에 쓴다.
struct MarkdownText: View {
    let raw: String
    var limit: Int? = nil
    var baseFont: Font = .callout

    var body: some View {
        let blocks = markdownBlocks(raw)
        let shown = limit.map { Array(blocks.prefix($0)) } ?? blocks
        VStack(alignment: .leading, spacing: Theme.Spacing.s) {
            if shown.isEmpty {
                // 블록이 하나도 안 잡히면(공백뿐 등) 원문 그대로 — 단 진짜 빈 본문은 안 그린다.
                if !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(verbatim: raw).font(baseFont)
                }
            } else {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, block in
                    MarkdownBlockView(block: block, baseFont: baseFont)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let baseFont: Font

    var body: some View {
        switch block {
        case let .heading(level, inline):
            // 1~2단계는 .headline(본문 callout 보다 한 단계 크게), 3+는 굵은 callout — 모두 시맨틱.
            inlineText(inline)
                .font(level <= 2 ? .headline : baseFont.weight(.bold))
                .padding(.top, Theme.Spacing.xxs)
        case let .paragraph(text):
            inlineText(text).font(baseFont)
        case let .bullet(indent, inline):
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.s) {
                Text(verbatim: "•").foregroundStyle(.secondary)
                inlineText(inline)
            }
            .font(baseFont)
            .padding(.leading, CGFloat(indent) * Theme.Spacing.xl)
        case let .ordered(marker, inline):
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.s) {
                Text(verbatim: marker).foregroundStyle(.secondary)
                inlineText(inline)
            }
            .font(baseFont)
        case let .task(checked, inline):
            // 체크박스는 spec 의 «수용 기준» 마커 — 상호작용 컨트롤이 아니다. status 색(success 등)을
            // 장식에 빌리지 않도록 중립(.secondary)으로 둔다(색 정책).
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.s) {
                Image(systemName: checked ? "checkmark.square" : "square")
                    .foregroundStyle(.secondary)
                inlineText(inline)
            }
            .font(baseFont)
        case let .code(code):
            Text(verbatim: code)
                .font(.system(.callout, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.m)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .fill(Theme.neutralFill.opacity(Theme.Opacity.hairline)),
                )
                .textSelection(.enabled)
        }
    }

    /// 인라인만(굵게/이탤릭/코드/링크) 해석 — 블록은 상위에서 이미 갈랐다. 파싱 실패 시 원문.
    /// 코드 스팬은 monospaced 로 강제해 식별자/코드가 렌더 후에도 코드처럼 보이게 한다.
    private func inlineText(_ s: String) -> Text {
        guard let attr = try? AttributedString(
            markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace),
        ) else {
            return Text(verbatim: s)
        }
        let codeRanges = attr.runs.compactMap { run in
            (run.inlinePresentationIntent?.contains(.code) ?? false) ? run.range : nil
        }
        var out = attr
        for r in codeRanges {
            out[r].font = .system(.callout, design: .monospaced)
        }
        return Text(out)
    }
}
