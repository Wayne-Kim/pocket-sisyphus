import Foundation
import Combine

/// 마지막으로 성공한 `GET /api/sessions` 응답을 디스크에 박아 두고, 다음 앱 진입 시
/// SessionsView 가 첫 페인트에 곧바로 그릴 수 있게 하는 캐시.
///
/// 동기/모델:
/// - 단일 source of truth — SessionsView 는 `@State sessions` 를 쓰지 않고 이 store 의
///   `@Published sessions` 만 본다. reload / rename / delete 도 이걸 통해서 mutate.
/// - 캐시 키 = 현재 페어링의 onion 주소. 다른 Mac 으로 re-pair 하면 옛 캐시는 자동 무시되고
///   빈 상태로 시작 (`adopt(onion:)` 의 mismatch 분기). 옛 entry 도 그 자리에서 삭제.
/// - prewarm (`PocketSisyphusApp.schedulePrewarmIfReady`) 가 `.active` 진입 시 병렬로
///   `listSessions` 를 발사 → 성공하면 여기에 `save(_:)` → SessionsView 가 자동 갱신.
///
/// 보안:
/// - 캐시 페이로드는 세션 id / 제목 / repo 경로 / 상태 메타 — Bearer token 이나 onion key
///   같은 비밀 자료는 없음. UserDefaults 에 평문 보관해도 위협 모델에 영향 없다.
/// - 페어링 해제 (`adopt(onion: nil)`) 또는 다른 Mac 으로 re-pair 시 영구 데이터도 즉시 청소.
@MainActor
final class SessionListCache: ObservableObject {
    private static let storageKey = "session_list_cache_v1"

    @Published private(set) var sessions: [SessionSummary] = []

    /// 현재 메모리에 로드된 캐시가 속한 onion. nil = 아직 입양되지 않았거나 페어링 없음.
    private var currentOnion: String?

    /// 현재 페어링 onion 으로 캐시를 메모리에 로드. 옛 onion 의 잔재가 디스크에 있으면 같이 청소.
    ///
    /// - onion=nil: 페어링 해제. 메모리 + 디스크 모두 비움.
    /// - onion 이 디스크 stored 와 일치: stored 그대로 채택 → SessionsView 즉시 그림.
    /// - onion 이 stored 와 다름 (다른 Mac): 메모리 빈 상태 + 옛 stored 삭제 → 새 페어링용 깨끗한 출발.
    func adopt(onion: String?) {
        guard currentOnion != onion else { return }
        currentOnion = onion
        guard let onion else {
            sessions = []
            UserDefaults.standard.removeObject(forKey: Self.storageKey)
            return
        }
        if let stored = Self.loadStored(), stored.onion == onion {
            sessions = stored.sessions
        } else {
            sessions = []
            UserDefaults.standard.removeObject(forKey: Self.storageKey)
        }
    }

    /// 서버에서 받은 새 목록으로 통째 교체. 메모리 + 디스크 동시 갱신.
    /// `adopt(onion:)` 가 먼저 호출돼 있어야 함 — 아니면 디스크 쓰기는 건너뜀 (메모리만 갱신).
    func save(_ list: [SessionSummary]) {
        sessions = list
        guard let onion = currentOnion else { return }
        Self.writeStored(Stored(onion: onion, sessions: list))
    }

    /// 부분 변형용 — rename/delete 가 호출. 블록 안에서 `inout` 으로 수정 후 동일 경로로 저장.
    func mutate(_ block: (inout [SessionSummary]) -> Void) {
        var copy = sessions
        block(&copy)
        save(copy)
    }

    private struct Stored: Codable {
        let onion: String
        let sessions: [SessionSummary]
    }

    private static func loadStored() -> Stored? {
        guard let data = UserDefaults.standard.data(forKey: storageKey) else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: data)
    }

    private static func writeStored(_ s: Stored) {
        if let data = try? JSONEncoder().encode(s) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
    }
}
