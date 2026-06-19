import Foundation

/// 프로(유료) 기능 게이트의 순수 판정. 전체화면 강제 페이월은 폐기됐고(프리미엄 전환),
/// 이제 «주황(Theme.pro) 기능을 탭할 때» 보유 여부로 막는다 — 기본 앱은 무료.
///
/// 게이트 판정을 뷰 body 밖 순수 함수로 빼서 host-less XCTest 로 핀을 박는다.
enum EntitlementDecision {
    /// IAP 게이트 마스터 스위치.
    ///
    /// false 동안(무료 출시 단계):
    ///  - `proUnlocked(...)` 가 무조건 true — 모든 프로 기능이 무료로 열린다(잠금 0).
    ///  - `PurchaseStore.init()` 가 StoreKit 구독 / product fetch 를 건너뛴다.
    ///
    /// App Store Connect 에 상품이 «승인» 된 뒤 true 로 바꾸면 프로 기능 잠금이 작동한다.
    static let iapEnabled = true

    /// 프로 기능을 사용할 수 있는가?
    ///  - iapEnabled == false → 항상 true (무료 단계엔 전부 무료).
    ///  - iapEnabled == true  → 보유/활성(구독 무료체험 포함 또는 평생) 여부 그대로.
    ///
    /// 테스트는 명시적으로 `iapEnabled: true` 를 넘겨 잠금 분기를 검증한다.
    static func proUnlocked(isEntitled: Bool, iapEnabled: Bool = Self.iapEnabled) -> Bool {
        !iapEnabled || isEntitled
    }
}

/// 앱의 모든 «프로(주황)» 기능 레지스트리 — «무엇이 프로인가» 를 한 곳에 모은 단일 진실.
///
/// 왜 있나: 프로 게이트가 뷰마다 `if purchase.isProUnlocked { … } else { 페이월 }` 인라인으로
/// 흩어져 있었고, 그래서 새 프로 진입점(새 세션의 worktree)이 게이트를 빼먹어 «무료로 열리는»
/// 회귀가 났다. 이제 규율은 하나다 — **프로 기능이면 반드시 이 enum 의 case 로 태깅하고
/// `PurchaseStore.gate(_:_:_:)` / `isUnlocked(_:)` 를 거친다.** 진입점이 타입(ProFeature)을
/// 요구하므로, 새 기능을 추가하면 «어떤 프로 기능인가» 를 명시하게 되고 게이트를 빼먹기 어렵다.
///
/// 색 정책(CLAUDE.md «주황=프로») 과 1:1 — 여기 있는 기능은 UI 에서 Theme.pro(주황)로 표시한다.
enum ProFeature: String, CaseIterable, Identifiable {
    case workflow        // 워크플로우 탭
    case poLoop          // 백로그 탭 (PO 루프 — 기회 브리프 수집/결재)
    case cron            // 예약 작업
    case monitorMirror   // 모니터 미러링(데스크톱 화면 라이브)
    case terminal        // Terminal(shell) 에이전트
    case localLLM        // 로컬 추론 에이전트 (local_llm=Qwen Code · opencode — 같은 llama-server 백엔드)
    case worktree        // git worktree 생성 — 새 세션 시트 + 채팅 BranchSheet 공통
    case chatTools       // 채팅 «고급 도구» (브랜치/worktree·파일 탐색·diff·이미지·세션 알림 음소거 등)
    case preview         // 라이브 프리뷰 — 폰에서 dev 서버(localhost:3000 류)를 WKWebView 로 렌더

    var id: String { rawValue }

    /// 새 세션 시트의 코드 에이전트 id → 프로 기능 매핑. 프로 전용 에이전트가 아니면 nil.
    static func forAgent(_ agentId: String) -> ProFeature? {
        switch agentId {
        case "shell": return .terminal
        // local_llm(Qwen Code) 과 opencode 는 둘 다 로컬 추론 백엔드를 쓰는 프로 전용 에이전트 —
        // 같은 .localLLM 게이트를 공유한다 (브리프: «Pro(.localLLM) 게이팅 재사용»).
        case "local_llm", "opencode": return .localLLM
        default: return nil
        }
    }
}
