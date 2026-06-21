import Foundation

/// 딥링크 «소비» 계약의 단일 정의(SSOT) — 순수 판정.
///
/// ## 위협
/// 악성 웹페이지/앱/메시지가 위조 `pocketsisyphus://` 딥링크를 발사해 (1) 잠금(Secure
/// Enclave) 인증을 건너뛰고 화면을 열거나 (2) 프로/capability 게이트를 우회해 고급 기능을
/// 무료로 여는 것.
///
/// ## 계약
/// `DeepLinkRouter.handle` 은 «상태만» 세팅한다(네비게이션·시트 present 없음). 실제 화면
/// «소비» 는 반드시 이 게이트를 통과해야 한다 — 잠금(needsAuthGate) + capability + 프로.
///
/// 이전엔 이 안전이 «뷰 렌더 순서» 에서 창발하는 암묵적 불변식이었다(AppRoot 가 LockView
/// 뒤에서만 소비 화면(MainTabView/SessionsView)을 그림). 향후 리팩터(예: onOpenURL 에서 직접
/// 시트 present)로 조용히 우회가 열려도 잡히지 않았다. 여기 순수 함수로 못박아 host-less
/// XCTest(`DeepLinkContractTests`)가 회귀를 잡는다. MainTabView 의 consume 가드가 아래 capability
/// 상수를 «그대로» 공유하므로, 뷰가 이 SSOT 를 우회하면 테스트가 깨진다.
enum DeepLinkConsumeGate {
    /// 각 딥링크 종류가 요구하는 daemon capability 키 — MainTabView 의 consume 가드와 공유한다.
    static let mirrorCapability = "screen_capture_v1"
    static let backlogCapability = "po_loop_v1"
    static let workflowCapability = "workflow_v1"

    /// 모든 딥링크 소비의 «최상위» 전제: 잠금 게이트(needsAuthGate)가 떠 있으면 어떤 pending 도
    /// 소비하지 않는다. AppRoot 가 LockView 뒤에서만 소비 화면을 그리는 계약을 명시화한 것.
    static func mayConsumeAny(authGated: Bool) -> Bool { !authGated }

    /// 세션 딥링크(`pocketsisyphus://session/<id>`) — 기본(무료) 기능. 잠금만 통과하면 소비.
    static func mayConsumeSession(authGated: Bool) -> Bool {
        mayConsumeAny(authGated: authGated)
    }

    /// 미러링(`pocketsisyphus://mirror`) — 잠금 + `screen_capture_v1` capability + 프로(monitorMirror).
    static func mayOpenMirror(authGated: Bool, capabilities: Set<String>, proUnlocked: Bool) -> Bool {
        mayConsumeAny(authGated: authGated)
            && capabilities.contains(mirrorCapability)
            && proUnlocked
    }

    /// 백로그(`pocketsisyphus://backlog`) — 잠금 + `po_loop_v1` capability + 프로(poLoop).
    static func mayOpenBacklog(authGated: Bool, capabilities: Set<String>, proUnlocked: Bool) -> Bool {
        mayConsumeAny(authGated: authGated)
            && capabilities.contains(backlogCapability)
            && proUnlocked
    }

    /// 워크플로우(`pocketsisyphus://workflow/<runId>`) — 잠금 + `workflow_v1` capability + 프로(workflow).
    static func mayOpenWorkflow(authGated: Bool, capabilities: Set<String>, proUnlocked: Bool) -> Bool {
        mayConsumeAny(authGated: authGated)
            && capabilities.contains(workflowCapability)
            && proUnlocked
    }
}
