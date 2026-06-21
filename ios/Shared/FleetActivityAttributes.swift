import ActivityKit
import Foundation

/// 「에이전트 함대」 Live Activity 의 attributes — 잠금화면/다이내믹 아일랜드가 그리는 지속 상태.
///
/// # 왜 Shared 인가
/// 앱(`Activity.request`/`update`/`end`)과 Widget Extension(렌더)이 «같은» 타입을 봐야
/// ActivityKit 이 둘을 묶는다. 그래서 이 파일은 두 타겟(`PocketSisyphus` + `PocketSisyphusWidget`)에
/// 함께 컴파일된다 (project.yml 의 widget 타겟 sources 에 이 파일이 개별 등록돼 있다).
///
/// # 보안/원칙 (브리프 비-목표)
/// `ContentState` 에는 «세션 식별 메타» — 카운트 · repo 폴더명 · 세션 제목 — 만 담는다.
/// 코드/대화 본문·에이전트 출력 미리보기(`pending_prompt_preview`)는 **절대** 싣지 않는다.
/// 잠금화면에 코드/대화를 노출하는 것은 이 앱의 원칙 위반이며, 이 브리프의 명시적 비-목표다.
struct FleetActivityAttributes: ActivityAttributes {
    /// 라이브로 바뀌는 부분 — 함대 카운트 + «가장 시급한 한 줄» 의 식별 메타.
    struct ContentState: Codable, Hashable {
        /// 입력/승인 대기 세션 수.
        var waiting: Int
        /// 실행 중 세션 수.
        var running: Int
        /// 완료(정상 완료 + 오류 종료) 세션 수.
        var done: Int
        /// 완료 중 «오류로 끝난» 수 — 완료 카운트에 붙는 danger 서브 신호(막힌 에이전트).
        var errors: Int

        // MARK: 가장 시급한 세션 한 줄 (없으면 nil — 실행만 있는 함대)
        /// 시급 세션 id — 탭 딥링크용. nil 이면 일반 요약 줄만 그린다.
        var urgentSessionId: String?
        /// repo 폴더명 (verbatim — 에이전트/사용자 데이터라 번역 대상 아님).
        var urgentRepoName: String?
        /// 세션 제목 (verbatim — 번역 대상 아님). 없을 수 있음.
        var urgentTitle: String?
        /// 시급 세션이 «대기»(입력 필요)인지 — true 면 accent(보라), false 면 success(초록)로 표시.
        var urgentIsWaiting: Bool

        init(
            waiting: Int, running: Int, done: Int, errors: Int,
            urgentSessionId: String? = nil, urgentRepoName: String? = nil,
            urgentTitle: String? = nil, urgentIsWaiting: Bool = false,
        ) {
            self.waiting = waiting
            self.running = running
            self.done = done
            self.errors = errors
            self.urgentSessionId = urgentSessionId
            self.urgentRepoName = urgentRepoName
            self.urgentTitle = urgentTitle
            self.urgentIsWaiting = urgentIsWaiting
        }

        /// 활성(대기+실행) 세션 수 — 0 이면 Activity 를 띄우지 않는다(빈 상태 정의: 활성 0건).
        var activeCount: Int { waiting + running }

        /// 시급 세션 딥링크 — `pocketsisyphus://session/<id>`.
        /// 스킴 리터럴은 앱의 `DeepLink.scheme`("pocketsisyphus") · `DeepLink.sessionHost`("session")
        /// 및 Info.plist 의 `CFBundleURLSchemes` 와 «1:1» 이어야 한다 — 위젯 타겟은 `DeepLink` 를
        /// 컴파일하지 않으므로(앱 전용 Service) 여기서 같은 리터럴을 미러한다.
        var urgentDeepLink: URL? {
            guard let id = urgentSessionId, !id.isEmpty else { return nil }
            return URL(string: "pocketsisyphus://session/\(id)")
        }
    }

    /// 스키마 버전 — 향후 `ContentState` 모양이 바뀔 때 앱/위젯 버전 불일치를 식별할 여지.
    var schemaVersion: Int

    init(schemaVersion: Int = 1) { self.schemaVersion = schemaVersion }
}
