import Foundation

/// 화면에 그릴 단위 아이템. 서버에서 받은 raw 이벤트를 사람-친화 형태로 변환.
enum ChatItem: Identifiable, Equatable {
    case user(id: String, text: String)
    case assistantText(id: String, text: String)
    case toolUse(id: String, name: String, inputSummary: String)
    case toolResult(id: String, isError: Bool, text: String)
    case turnComplete(id: String, costUsd: Double?, inputTokens: Int?, outputTokens: Int?)
    // PTY 모드 — daemon 이 messages.type='pty_chunk' 로 저장한 raw bytes 를 SwiftTerm.TerminalView 에
    // 그대로 feed 하기 위한 매개. 화면 자체는 SwiftTerm 이 그리므로 별도 itemView 표시는 없다.
    case ptyChunk(id: String, bytesB64: String)

    var id: String {
        switch self {
        case .user(let id, _), .assistantText(let id, _),
             .toolUse(let id, _, _), .toolResult(let id, _, _):
            return id
        case .turnComplete(let id, _, _, _):
            return id
        case .ptyChunk(let id, _):
            return id
        }
    }
}

/// MessageRow.payload JSON 문자열을 ChatItem 시퀀스로 변환.
enum ChatItemMapper {
    static func map(_ row: MessageRow) -> [ChatItem] {
        guard let data = row.payload.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [] }

        let type = (obj["type"] as? String) ?? row.type
        switch type {
        case "user_message":
            let text = (obj["text"] as? String) ?? ""
            return [.user(id: row.id, text: text)]

        case "assistant":
            let message = obj["message"] as? [String: Any]
            let content = (message?["content"] as? [[String: Any]]) ?? []
            var out: [ChatItem] = []
            for (idx, block) in content.enumerated() {
                let blockType = (block["type"] as? String) ?? ""
                if blockType == "text" {
                    let text = (block["text"] as? String) ?? ""
                    if !text.isEmpty {
                        out.append(.assistantText(id: "\(row.id)-\(idx)", text: text))
                    }
                } else if blockType == "tool_use" {
                    let name = (block["name"] as? String) ?? "?"
                    let input = block["input"] as? [String: Any]
                    let summary = summarize(toolName: name, input: input)
                    out.append(.toolUse(id: (block["id"] as? String) ?? "\(row.id)-tu-\(idx)",
                                        name: name, inputSummary: summary))
                }
            }
            return out

        case "user":
            // 두 가지 모양을 모두 처리한다:
            //  1) message.content 가 string — 데스크탑 jsonl 의 평문 user 메시지.
            //  2) message.content 가 [block] — tool_result / text 블록 배열.
            // daemon 본인이 합성하는 user 이벤트는 "user_message" 라 여기 안 들어옴.
            let message = obj["message"] as? [String: Any]
            if let plain = message?["content"] as? String, !plain.isEmpty {
                return [.user(id: row.id, text: plain)]
            }
            let content = (message?["content"] as? [[String: Any]]) ?? []
            var out: [ChatItem] = []
            for (idx, block) in content.enumerated() {
                let blockType = (block["type"] as? String) ?? ""
                if blockType == "tool_result" {
                    let isError = (block["is_error"] as? Bool) ?? false
                    let text: String
                    if let s = block["content"] as? String {
                        text = s
                    } else if let arr = block["content"] as? [[String: Any]] {
                        text = arr.compactMap { ($0["text"] as? String) }.joined(separator: "\n")
                    } else {
                        text = ""
                    }
                    out.append(.toolResult(id: "\(row.id)-tr-\(idx)", isError: isError, text: text))
                } else if blockType == "text" {
                    // jsonl 에서는 user 도 [{type:"text", text:"..."}] 배열로 올 수 있음.
                    let text = (block["text"] as? String) ?? ""
                    if !text.isEmpty {
                        out.append(.user(id: "\(row.id)-\(idx)", text: text))
                    }
                }
            }
            return out

        case "result":
            let cost = obj["total_cost_usd"] as? Double
            let usage = obj["usage"] as? [String: Any]
            let inTok = (usage?["input_tokens"] as? Int)
                ?? (usage?["input_tokens"] as? NSNumber)?.intValue
            let outTok = (usage?["output_tokens"] as? Int)
                ?? (usage?["output_tokens"] as? NSNumber)?.intValue
            return [.turnComplete(
                id: row.id,
                costUsd: cost,
                inputTokens: inTok,
                outputTokens: outTok
            )]

        case "pty_chunk":
            // payload = { bytes_b64: string }. SwiftTerm.TerminalView 가 raw bytes 그대로 feed.
            let b64 = (obj["bytes_b64"] as? String) ?? ""
            return [.ptyChunk(id: row.id, bytesB64: b64)]

        case "pty_user_input", "pty_exit":
            // SwiftTerm 화면에 이미 표시되므로 별도 ChatItem 생성 안 함.
            return []

        default:
            return []
        }
    }

    private static func summarize(toolName: String, input: [String: Any]?) -> String {
        guard let input else { return "" }
        switch toolName {
        case "Write":
            if let p = input["file_path"] as? String { return p }
        case "Edit", "MultiEdit":
            if let p = input["file_path"] as? String { return p }
        case "Read":
            if let p = input["file_path"] as? String { return p }
        case "Bash":
            if let c = input["command"] as? String { return c.prefix(80) + (c.count > 80 ? "…" : "") }
        case "LS", "Glob":
            if let p = input["path"] as? String { return p }
        default:
            break
        }
        return ""
    }
}
