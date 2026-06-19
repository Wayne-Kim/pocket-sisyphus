import Foundation

/// 한 번 도는 데이터 마이그레이션.
///
/// ## 두 단계의 brand rename 을 흡수
/// 1. 초기 0.2.0 빌드: sandbox=ON. daemon 상태가
///    `~/Library/Containers/pe.wayne.pocketclaude.mac/Data/Library/Application Support/PocketClaude/`
///    안에 있었다.
/// 2. 그 다음 빌드: sandbox=OFF + bundleId 그대로. 상태가
///    `~/Library/Application Support/PocketClaude/` 로 이동.
/// 3. 현재 (Pocket Sisyphus rename 후): bundleId `pe.wayne.pocketsisyphus.mac`. 상태가
///    `~/Library/Application Support/PocketSisyphus/` 에 있어야 한다.
///
/// 이 함수는 새 경로 (PocketSisyphus) 가 비어 있는 첫 실행에서, 우선순위대로
/// 옛 경로 두 곳을 찾아 한 번 통째로 복사한다. 멱등 — 새 경로에 이미 데이터가
/// 있거나 옛 경로 모두 비어 있으면 즉시 return.
///
/// 데이터 내부 파일명도 함께 정정:
///   `pocket-claude.db` (+ `-shm` / `-wal`) → `pocket-sisyphus.db`.
/// 옛 daemon 빌드는 전자 이름으로 SQLite 를 만들었고, 새 daemon 은 후자 이름을 연다.
///
/// 옛 디렉토리 / 컨테이너는 삭제하지 않는다 — 사용자가 직접 정리할 수 있게 둠.
enum DataMigration {
    static func runOnce() {
        let fm = FileManager.default
        guard let homeRealStr = NSHomeDirectoryForUser(NSUserName()) else {
            NSLog("[migration] real home 디렉터리 못 찾음 — 스킵")
            return
        }

        let newSupport = "\(homeRealStr)/Library/Application Support/PocketSisyphus"

        // 새 경로에 이미 config.json 있으면 끝난 거.
        if fm.fileExists(atPath: "\(newSupport)/config.json") {
            NSLog("[migration] 새 경로에 config.json 이미 존재 — 스킵")
            return
        }

        // 우선순위 1: 직전 빌드의 unsandboxed 경로 (대부분의 현 사용자).
        // 우선순위 2: 그 이전 sandboxed 컨테이너 경로 (초기 0.2.0 사용자).
        let candidates: [String] = [
            "\(homeRealStr)/Library/Application Support/PocketClaude",
            "\(homeRealStr)/Library/Containers/pe.wayne.pocketclaude.mac/Data/Library/Application Support/PocketClaude",
        ]

        guard let sourcePath = candidates.first(where: {
            fm.fileExists(atPath: "\($0)/config.json")
        }) else {
            NSLog("[migration] 옛 데이터 없음 — fresh install 로 진행")
            return
        }

        // 새 경로의 부모 디렉토리 보장.
        do {
            try fm.createDirectory(
                atPath: "\(homeRealStr)/Library/Application Support",
                withIntermediateDirectories: true,
            )
        } catch {
            NSLog("[migration] 부모 디렉터리 생성 실패: %@", error.localizedDescription)
            return
        }

        // 전체 트리 통째로 복사 (config + db + tor/ 합쳐도 < 10 MB).
        do {
            try fm.copyItem(atPath: sourcePath, toPath: newSupport)
            NSLog("[migration] %@ → %@ 복사 성공", sourcePath, newSupport)
        } catch {
            NSLog("[migration] 복사 실패: %@", error.localizedDescription)
            try? fm.removeItem(atPath: newSupport)
            return
        }

        // SQLite 파일명 정정 — daemon 의 새 코드는 pocket-sisyphus.db 만 연다.
        // -shm / -wal 도 같이 따라와야 WAL 모드가 그대로 이어진다.
        for ext in ["", "-shm", "-wal"] {
            let old = "\(newSupport)/pocket-claude.db\(ext)"
            let new = "\(newSupport)/pocket-sisyphus.db\(ext)"
            if fm.fileExists(atPath: old) {
                do {
                    try fm.moveItem(atPath: old, toPath: new)
                } catch {
                    NSLog("[migration] %@ → %@ 리네임 실패: %@",
                          old, new, error.localizedDescription)
                }
            }
        }

        // Tor HiddenServiceDir 권한 보정 — 0700 아니면 tor 가 부팅 거부.
        for sub in ["tor/hs", "tor/data"] {
            let p = "\(newSupport)/\(sub)"
            if fm.fileExists(atPath: p) {
                _ = try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: p)
            }
        }
    }
}
