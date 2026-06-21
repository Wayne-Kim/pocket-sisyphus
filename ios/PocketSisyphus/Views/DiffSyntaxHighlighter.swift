import Runestone
import SwiftUI
import UIKit

import TreeSitterBashRunestone
import TreeSitterCPPRunestone
import TreeSitterCRunestone
import TreeSitterCSSRunestone
import TreeSitterGoRunestone
import TreeSitterHTMLRunestone
import TreeSitterJSONRunestone
import TreeSitterJavaRunestone
import TreeSitterJavaScriptRunestone
import TreeSitterMarkdownRunestone
import TreeSitterPHPRunestone
import TreeSitterPythonRunestone
import TreeSitterRubyRunestone
import TreeSitterRustRunestone
import TreeSitterSQLRunestone
import TreeSitterSwiftRunestone
import TreeSitterTOMLRunestone
import TreeSitterTSXRunestone
import TreeSitterTypeScriptRunestone
import TreeSitterYAMLRunestone

/// unified diff 본문에 파일 확장자에 맞는 syntax highlighting 을 입힌다 (DiffBody 가 소비).
///
/// 전략 — «hunk 단위 가상 문서»:
/// diff 를 라인 단위로 따로 하이라이트하면 여러 줄 문자열/주석의 파서 상태가 줄마다 끊긴다.
/// 대신 hunk 마다 「old 문서(컨텍스트+삭제 라인)」와 「new 문서(컨텍스트+추가 라인)」를
/// 재구성해 각각 통째로 tree-sitter(Runestone StringSyntaxHighlighter)에 태우고, 결과를
/// 라인 단위로 잘라 diff 라인 인덱스에 되돌려 매핑한다. 삭제 라인은 old 문서에서,
/// 추가/컨텍스트 라인은 new 문서에서 색을 가져온다.
///
/// 반환되는 AttributedString 에는 «전경색만» 싣는다 — 폰트/크기는 DiffLine 의 `.font(...)`
/// modifier 가 정한다 (여기서 UIFont 를 박으면 modifier 를 이겨버려 Dynamic Type 이 깨진다).
/// 토큰 색은 `Theme.Syntax.Diff` (라이트/다크 적응) 팔레트.
enum DiffSyntaxHighlighter {

    /// diff 본문 전체를 하이라이트한다. 동기 — 호출자는 메인 스레드 밖에서 돌릴 것.
    /// - Returns: diff 의 각 줄과 1:1 인 배열. nil 원소 = 하이라이트 없음 (메타/hunk 헤더 줄 —
    ///   DiffLine 의 기존 prefix 색칠로 렌더). 언어를 모르는 확장자면 통째로 nil 을 반환해
    ///   기존 렌더 경로를 그대로 탄다.
    static func highlight(diff: String, path: String) -> [AttributedString?]? {
        guard let language = language(forPath: path) else { return nil }
        let lines = diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let highlighter = StringSyntaxHighlighter(theme: DiffTheme(), language: language)
        var result = [AttributedString?](repeating: nil, count: lines.count)

        for hunk in hunkBodyRanges(in: lines) {
            // old/new 가상 문서 — 컨텍스트 줄은 양쪽 문서 모두에 넣는다 (파서 상태 유지용).
            // 표시는 new 쪽 결과를 쓰므로 old 쪽 인덱스는 -1(매핑 안 함)로 둔다.
            var oldIndices: [Int] = [], oldLines: [String] = []
            var newIndices: [Int] = [], newLines: [String] = []
            for i in hunk {
                let line = lines[i]
                switch line.first {
                case "-":
                    oldIndices.append(i); oldLines.append(String(line.dropFirst()))
                case "+":
                    newIndices.append(i); newLines.append(String(line.dropFirst()))
                case "\\":
                    continue // «\ No newline at end of file» 마커 — 메타로 둔다.
                default:
                    let content = line.isEmpty ? "" : String(line.dropFirst())
                    oldIndices.append(-1); oldLines.append(content)
                    newIndices.append(i); newLines.append(content)
                }
            }
            apply(highlighter, docLines: oldLines, indices: oldIndices, originals: lines, into: &result)
            apply(highlighter, docLines: newLines, indices: newIndices, originals: lines, into: &result)
        }
        return result
    }

    // MARK: - hunk 경계

    /// `@@` 헤더 «다음» 줄부터 hunk 본문(+/-/컨텍스트/빈 줄/`\` 마커)이 이어지는 범위들.
    /// 본문이 아닌 줄(`diff --git`, `index`, 다음 `@@` 등)을 만나면 hunk 가 끝난다.
    private static func hunkBodyRanges(in lines: [String]) -> [Range<Int>] {
        var ranges: [Range<Int>] = []
        var i = 0
        while i < lines.count {
            guard lines[i].hasPrefix("@@") else { i += 1; continue }
            var j = i + 1
            scan: while j < lines.count {
                switch lines[j].first {
                case "+"?, "-"?, " "?, "\\"?, nil:
                    j += 1
                default:
                    break scan
                }
            }
            if j > i + 1 { ranges.append((i + 1)..<j) }
            i = j
        }
        return ranges
    }

    // MARK: - 가상 문서 하이라이트 → 라인 매핑

    private static func apply(
        _ highlighter: StringSyntaxHighlighter,
        docLines: [String],
        indices: [Int],
        originals: [String],
        into result: inout [AttributedString?],
    ) {
        guard indices.contains(where: { $0 >= 0 }) else { return }
        let doc = docLines.joined(separator: "\n")
        let highlighted = highlighter.syntaxHighlight(doc)
        var location = 0
        for (row, content) in docLines.enumerated() {
            let length = (content as NSString).length
            defer { location += length + 1 } // +1 = 줄바꿈
            let diffIndex = indices[row]
            guard diffIndex >= 0 else { continue }
            let lineRange = NSRange(location: location, length: length)
            result[diffIndex] = styledLine(
                content: highlighted.attributedSubstring(from: lineRange),
                original: originals[diffIndex],
            )
        }
    }

    /// NSAttributedString(토큰색) → SwiftUI AttributedString. prefix 글자(+/-/공백)를 앞에
    /// 되붙이고 «변경 종류» 색으로 칠한다 — 본문은 토큰색, 종류는 prefix + 배경 tint 가 말한다.
    private static func styledLine(content: NSAttributedString, original: String) -> AttributedString {
        var out = AttributedString()
        if let first = original.first {
            var prefix = AttributedString(String(first))
            switch first {
            case "+": prefix.foregroundColor = Theme.success
            case "-": prefix.foregroundColor = Theme.danger
            default: break
            }
            out += prefix
        }
        let full = NSRange(location: 0, length: content.length)
        content.enumerateAttribute(.foregroundColor, in: full) { value, range, _ in
            var piece = AttributedString((content.string as NSString).substring(with: range))
            // 기본 본문색(.label)은 안 싣는다 — 명시 안 하면 SwiftUI 가 .primary 로 그린다.
            if let color = value as? UIColor, color != .label {
                piece.foregroundColor = Color(uiColor: color)
            }
            out += piece
        }
        // 빈 줄도 배경 높이를 가져야 하므로 공백 한 칸.
        if out.characters.isEmpty { out = AttributedString(" ") }
        return out
    }

    // MARK: - 확장자 → 언어

    /// 지원 언어는 project.yml 의 TreeSitterLanguages product 목록과 1:1 — 추가/삭제 시 같이 맞춘다.
    private static func language(forPath path: String) -> TreeSitterLanguage? {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "swift": return .swift
        case "ts", "mts", "cts": return .typeScript
        case "tsx": return .tsx
        case "js", "mjs", "cjs", "jsx": return .javaScript
        case "py": return .python
        case "json": return .json
        case "yml", "yaml": return .yaml
        case "toml": return .toml
        case "md", "markdown": return .markdown
        case "html", "htm": return .html
        case "css": return .css
        case "sh", "bash", "zsh": return .bash
        case "c", "h": return .c
        case "cpp", "cc", "cxx", "hpp": return .cpp
        case "go": return .go
        case "rs": return .rust
        case "rb": return .ruby
        case "java": return .java
        case "php": return .php
        case "sql": return .sql
        case "":
            // 확장자 없는 관용 파일명.
            switch (path as NSString).lastPathComponent.lowercased() {
            case "podfile", "gemfile", "fastfile", "rakefile": return .ruby
            default: return nil
            }
        default: return nil
        }
    }
}

/// Runestone 테마 — `textColor(for:)` 의 토큰색만 의미 있게 쓴다. StringSyntaxHighlighter 는
/// TextView 없이 돌므로 gutter/selection 류 값은 소비되지 않지만 프로토콜이 요구해 형식적으로 채운다.
private final class DiffTheme: Runestone.Theme {
    let font: UIFont = .monospacedSystemFont(ofSize: 13, weight: .regular)
    let textColor: UIColor = .label
    let gutterBackgroundColor: UIColor = .clear
    let gutterHairlineColor: UIColor = .clear
    let lineNumberColor: UIColor = .clear
    let lineNumberFont: UIFont = .monospacedSystemFont(ofSize: 13, weight: .regular)
    let selectedLineBackgroundColor: UIColor = .clear
    let selectedLinesLineNumberColor: UIColor = .clear
    let selectedLinesGutterBackgroundColor: UIColor = .clear
    let invisibleCharactersColor: UIColor = .clear
    let pageGuideHairlineColor: UIColor = .clear
    let pageGuideBackgroundColor: UIColor = .clear
    let markedTextBackgroundColor: UIColor = .clear

    func textColor(for highlightName: String) -> UIColor? {
        // capture 이름은 «keyword.function» 처럼 점 계층 — 뒤 성분을 줄여가며 매칭
        // (Runestone 내부 HighlightName 과 같은 규칙).
        var components = highlightName.split(separator: ".").map(String.init)
        while !components.isEmpty {
            if let color = Self.palette[components.joined(separator: ".")] { return color }
            components.removeLast()
        }
        return nil
    }

    // operator/punctuation/variable 은 본문색(.label) 그대로 — 모든 토큰을 칠하면 오히려 안 읽힌다.
    private static let palette: [String: UIColor] = [
        "comment": Theme.Syntax.Diff.comment,
        "string": Theme.Syntax.Diff.string,
        "constant.character": Theme.Syntax.Diff.string,
        "number": Theme.Syntax.Diff.number,
        "keyword": Theme.Syntax.Diff.keyword,
        "type": Theme.Syntax.Diff.type,
        "constructor": Theme.Syntax.Diff.type,
        "function": Theme.Syntax.Diff.function,
        "property": Theme.Syntax.Diff.property,
        "variable.builtin": Theme.Syntax.Diff.builtin,
        "constant.builtin": Theme.Syntax.Diff.builtin,
    ]
}
