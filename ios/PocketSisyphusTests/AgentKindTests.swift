import Testing

// AgentKind.swift 는 host-less library test 패턴으로 이 테스트 번들에 직접 컴파일된다
// (project.yml 의 PocketSisyphusTests.sources 참고).
//
// Swift Testing (Xcode 16+, Swift 6) 으로 작성된 이 프로젝트의 첫 테스트. 기존 XCTest
// 테스트 (Entitlement / Trial / PtyByteBuffer) 는 그대로 유지하고, 신규 테스트만 Swift
// Testing 으로 점진 도입한다.

/// daemon 의 raw agent id 가 UI 가 다루는 `AgentKind` 로 정확히 매핑되는지 — 회귀 차단.
///
/// 표적 케이스:
///  - 알려진 adapter id 가 각자 enum case 로
///  - nil (옛 daemon) 이 claudeCode 로 fallback
///  - 모르는 id 가 `.unknown(raw)` 로 — view 가 raw id 를 노출해 사용자 인지 가능
@Suite("AgentKind.from(id:)")
struct AgentKindFromIdTests {
    @Test("알려진 adapter id 매핑")
    func knownIds() {
        #expect(AgentKind.from(id: "claude_code") == .claudeCode)
        #expect(AgentKind.from(id: "shell") == .shell)
        #expect(AgentKind.from(id: "codex") == .codex)
        #expect(AgentKind.from(id: "agy") == .antigravity)
        #expect(AgentKind.from(id: "local_llm") == .localLlm)
        #expect(AgentKind.from(id: "opencode") == .openCode)
        #expect(AgentKind.from(id: "copilot") == .copilot)
    }

    @Test("nil 은 claudeCode 로 (옛 daemon 호환)")
    func nilFallsBackToClaudeCode() {
        #expect(AgentKind.from(id: nil) == .claudeCode)
    }

    @Test("모르는 id 는 raw 를 보존한 .unknown 으로")
    func unknownIdRetainsRaw() {
        let k = AgentKind.from(id: "gemini_cli")
        #expect(k == .unknown("gemini_cli"))
        // 빈 문자열은 «알려진 어떤 것도 아님» — fallback 이 아니라 unknown 가지로 떨어져야
        // 다음 turn 에 daemon 응답 조사 단서가 된다.
        #expect(AgentKind.from(id: "") == .unknown(""))
    }
}

@Suite("AgentKind.displayName")
struct AgentKindDisplayNameTests {
    @Test("브랜드명 매핑 — 번역 대상 아님")
    func brandNames() {
        #expect(AgentKind.claudeCode.displayName == "Claude Code")
        #expect(AgentKind.shell.displayName == "Terminal")
        #expect(AgentKind.codex.displayName == "Codex")
        #expect(AgentKind.antigravity.displayName == "Antigravity")
        #expect(AgentKind.localLlm.displayName == "Qwen Code")
        #expect(AgentKind.openCode.displayName == "OpenCode")
        #expect(AgentKind.copilot.displayName == "Copilot")
    }

    @Test("unknown 은 raw id 를 그대로 노출")
    func unknownReturnsRawId() {
        #expect(AgentKind.unknown("gemini_cli").displayName == "gemini_cli")
    }
}

@Suite("AgentKind.systemImage")
struct AgentKindSystemImageTests {
    @Test("각 kind 가 고유한 SF Symbol name 을 반환")
    func eachKindHasDistinctSymbol() {
        let symbols: [String] = [
            AgentKind.claudeCode.systemImage,
            AgentKind.shell.systemImage,
            AgentKind.codex.systemImage,
            AgentKind.antigravity.systemImage,
            AgentKind.localLlm.systemImage,
            AgentKind.openCode.systemImage,
            AgentKind.copilot.systemImage,
            AgentKind.unknown("x").systemImage,
        ]
        // 시각적으로 alias 인 채로 회귀하지 않도록 — 모두 distinct.
        #expect(Set(symbols).count == symbols.count)
        // unknown 은 questionmark.circle 로 고정 (사용자가 «새 종류» 임을 알아야 함).
        #expect(AgentKind.unknown("gemini_cli").systemImage == "questionmark.circle")
    }
}
