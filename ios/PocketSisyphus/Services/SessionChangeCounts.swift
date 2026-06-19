import Foundation

/// 세션 목록(오케스트레이션 뷰) 카드의 «변경 파일 수» 를 lazy 로 채우는 가벼운 캐시.
///
/// 설계 의도 — 모바일·Tor 친화:
/// - 세션 목록 응답(SessionSummary)에는 변경 파일 수가 없다(daemon 이 매 목록마다 N개
///   세션의 `git status` 를 도는 건 비싸다). 그래서 목록 자체는 캐시에서 즉시 그리고,
///   각 카드가 «화면에 보일 때» 그 세션 하나만 `gitStatus` 로 채운다 (보이는 만큼만 호출).
/// - 한 번 채운 값은 뷰 수명 동안 캐시 — 같은 카드가 다시 보여도 재요청하지 않는다.
/// - pull-to-refresh 같은 «명시적» 갱신에서만 `refresh(ids:)` 로 현재 보이는 세션을
///   다시 받는다(전체 fan-out 아님 — 인자로 받은 id 들만).
/// - 라벨 없이(label nil) 호출해 in-flight 배너에 잡히지 않게 한다(조용한 백그라운드 보강).
/// - daemon 이 `session_git_status_v1` 미지원이거나 repo 가 아니면 total==0 → 칩이 안 뜬다.
@MainActor
final class SessionChangeCounts: ObservableObject {
    /// sessionId → 커밋되지 않은 변경 파일 수. 아직 안 받은 세션은 키 없음(=알 수 없음).
    @Published private(set) var counts: [String: Int] = [:]

    private var auth: AuthStore?
    private var conn: ConnectionManager?
    /// 동시/중복 요청 가드 — 같은 세션을 두 번 받지 않게.
    private var inFlight: Set<String> = []

    /// SessionsView 의 환경 객체를 주입 — @StateObject init 시점엔 EnvironmentObject 가 없어
    /// .task 에서 한 번 묶는다. 멱등.
    func bind(auth: AuthStore, conn: ConnectionManager) {
        self.auth = auth
        self.conn = conn
    }

    /// 알려진 변경 파일 수 (없으면 nil).
    func count(for sessionId: String) -> Int? { counts[sessionId] }

    /// 카드가 화면에 보일 때 lazy 로 채운다. 이미 받았거나 받는 중이면 아무것도 안 한다.
    func loadIfNeeded(_ sessionId: String) {
        guard counts[sessionId] == nil else { return }
        fetch(sessionId)
    }

    /// 명시적 갱신(pull-to-refresh) — 인자로 받은 세션들만 캐시를 무시하고 다시 받는다.
    func refresh(ids: [String]) {
        for id in ids { fetch(id) }
    }

    private func fetch(_ sessionId: String) {
        guard let auth, let conn else { return }
        guard !inFlight.contains(sessionId) else { return }
        inFlight.insert(sessionId)
        let api = ApiClient(auth: auth, conn: conn, tracker: nil)
        Task { [weak self] in
            // label 은 nil — 폴링처럼 조용히. 실패(미지원/비-repo/네트워크)는 무시: 칩이
            // 안 뜰 뿐 목록 동작엔 영향 없음.
            let total = (try? await api.gitStatus(sessionId: sessionId))?.total
            await MainActor.run {
                guard let self else { return }
                self.inFlight.remove(sessionId)
                if let total { self.counts[sessionId] = total }
            }
        }
    }
}
