import Foundation
import Combine

/// 숨김 이어받기 세션 한 건의 메타데이터. 사용자가 숨길 때의 시야 정보를 그대로 stash —
/// «숨김 관리» 화면에서 어떤 세션을 숨겼는지 한눈에 알아볼 수 있게 한다 (sessionId 만으로는
/// 알아보기 불가능).
struct HiddenResumeMeta: Codable, Identifiable, Equatable {
    let sessionId: String
    let repoPath: String
    /// 첫 user 메시지 미리보기. agent 가 못 추출하는 케이스 (agy 의 .pb 디코드 불가) 는
    /// nil — UI 가 sessionId prefix 같은 fallback 으로 표시.
    let preview: String?
    let lastActiveAt: Int64
    let gitBranch: String?

    var id: String { sessionId }
}

/// 새 세션 시트에서 사용자가 «숨김» 처리한 항목들 — 레포 경로 / 데스크탑 이어받기 세션 —
/// 을 디스크에 보관하고 두 카테고리를 한 store 로 노출한다. 서버는 숨김 여부를 모르고
/// 클라이언트 단에서만 필터링한다 (다른 기기에서는 다른 사용자의 시야가 다를 수 있어
/// 굳이 동기화하지 않는다).
@MainActor
final class HiddenItemsStore: ObservableObject {
    private static let recentKey = "hidden_recent_project_paths"
    private static let resumeKey = "hidden_resume_sessions_v1"

    @Published private(set) var hiddenRecentPaths: Set<String>
    @Published private(set) var hiddenResumes: [HiddenResumeMeta]

    init() {
        let recents = UserDefaults.standard.stringArray(forKey: Self.recentKey) ?? []
        self.hiddenRecentPaths = Set(recents)

        if let data = UserDefaults.standard.data(forKey: Self.resumeKey),
           let decoded = try? JSONDecoder().decode([HiddenResumeMeta].self, from: data) {
            self.hiddenResumes = decoded
        } else {
            self.hiddenResumes = []
        }
    }

    func isRecentHidden(_ path: String) -> Bool {
        hiddenRecentPaths.contains(path)
    }

    func isResumeHidden(_ id: String) -> Bool {
        hiddenResumes.contains(where: { $0.sessionId == id })
    }

    func hideRecent(_ path: String) {
        guard !hiddenRecentPaths.contains(path) else { return }
        hiddenRecentPaths.insert(path)
        persistRecents()
    }

    func unhideRecent(_ path: String) {
        guard hiddenRecentPaths.contains(path) else { return }
        hiddenRecentPaths.remove(path)
        persistRecents()
    }

    func hideResume(_ meta: HiddenResumeMeta) {
        if let idx = hiddenResumes.firstIndex(where: { $0.sessionId == meta.sessionId }) {
            hiddenResumes[idx] = meta
        } else {
            hiddenResumes.append(meta)
        }
        persistResumes()
    }

    func unhideResume(_ id: String) {
        guard let idx = hiddenResumes.firstIndex(where: { $0.sessionId == id }) else { return }
        hiddenResumes.remove(at: idx)
        persistResumes()
    }

    private func persistRecents() {
        UserDefaults.standard.set(Array(hiddenRecentPaths), forKey: Self.recentKey)
    }

    private func persistResumes() {
        if let data = try? JSONEncoder().encode(hiddenResumes) {
            UserDefaults.standard.set(data, forKey: Self.resumeKey)
        }
    }
}
