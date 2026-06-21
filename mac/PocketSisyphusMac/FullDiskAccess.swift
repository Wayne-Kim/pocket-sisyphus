import AppKit
import Foundation

/// 전체 디스크 접근 권한(Full Disk Access, FDA) 헬퍼.
///
/// 왜 필요한가: 이 앱은 샌드박스가 꺼져 있고(project.yml `ENABLE_APP_SANDBOX=NO`) daemon
/// (Node 자식)이 부모 권한을 상속해 임의 repo 경로에 접근한다. 다만 repo 가 macOS TCC 가
/// 보호하는 폴더(Documents·Desktop·Downloads·iCloud Drive 등) 밑에 있으면, 접근할 때마다
/// «"폴더"에 접근하려고 합니다» 프롬프트가 뜬다. FDA 를 한 번 부여하면 그 프롬프트들이
/// 모두 사라진다 — 사용자가 매번 허용을 누르지 않아도 된다.
enum FullDiskAccess {
    /// FDA 부여 여부를 «추정». macOS 는 FDA 상태를 직접 묻는 공개 API 를 주지 않으므로,
    /// FDA 가 있어야만 읽히는 경로(사용자 TCC.db)를 실제로 열어보고 성공 여부로 판정한다.
    /// OS 버전에 따라 달라질 수 있는 휴리스틱이라 100% 보장은 아니다 — false negative 가
    /// 나도 메뉴에 «허용됨» 체크가 안 뜰 뿐, 동작이나 안내에는 지장이 없다.
    static var isProbablyGranted: Bool {
        let probe = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db")
        // 파일 자체가 없으면 판정 불가 → 보수적으로 false (안내만 더 노출될 뿐).
        guard FileManager.default.fileExists(atPath: probe.path) else { return false }
        guard let handle = try? FileHandle(forReadingFrom: probe) else { return false }
        try? handle.close()
        return true
    }

    /// 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한 창을 연다.
    /// 사용자가 거기서 Pocket Sisyphus 를 목록에 추가하고 토글을 켜면 된다.
    @MainActor
    static func openSettings() {
        guard let url = URL(string:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        else { return }
        NSWorkspace.shared.open(url)
    }
}
