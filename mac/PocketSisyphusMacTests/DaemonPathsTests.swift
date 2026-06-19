import Testing
import Foundation

/// `DaemonPaths` 의 경로 산출 단위 테스트.
///
/// host-less library tests 패턴 (iOS PocketSisyphusTests 와 같은 모양) — Bundle.main 은
/// 이 테스트 번들이 된다. 그래서 daemon 번들 위치 (`Resources/daemon`) 는 「존재하지
/// 않는 경로」 가 되지만, 산출 *형태* 는 그대로 검증 가능.
///
/// 회귀 차단 대상:
///  - configDir 가 «~/Library/Application Support/PocketSisyphus» 의 모양 (bundleId 가
///    바뀌어도 사용자 데이터 위치가 안 따라가야 한다 — DataMigration 이 그 가정에 기댐)
///  - 하위 파일들이 옛 코드/스크립트가 기대하는 경로 (tor/hs/hostname, pair-qr.png 등)
///  - daemonEntry 의 끝이 [tsx, src/index.ts] — daemon 부팅 명령이 이걸 보고 만들어짐

@Suite("DaemonPaths — config 경로")
struct DaemonPathsConfigTests {
    @Test("configDir 끝이 PocketSisyphus")
    func configDirSuffix() {
        let p = DaemonPaths.configDir.path
        #expect(p.hasSuffix("/PocketSisyphus"))
        #expect(p.contains("/Library/Application Support/"))
    }

    @Test("configFile 가 configDir + config.json")
    func configFileLayout() {
        #expect(
            DaemonPaths.configFile.path
                == DaemonPaths.configDir.appendingPathComponent("config.json").path
        )
    }

    @Test("onionHostnameFile 는 tor/hs/hostname")
    func onionHostnameSuffix() {
        #expect(DaemonPaths.onionHostnameFile.path.hasSuffix("/tor/hs/hostname"))
    }

    @Test("pairQRFile 는 pair-qr.png")
    func pairQRSuffix() {
        #expect(DaemonPaths.pairQRFile.path.hasSuffix("/pair-qr.png"))
    }

    @Test("torLogFile 는 tor/tor.log")
    func torLogSuffix() {
        #expect(DaemonPaths.torLogFile.path.hasSuffix("/tor/tor.log"))
    }
}

@Suite("DaemonPaths — 번들 daemon 경로")
struct DaemonPathsBundleTests {
    @Test("daemonProjectDir 끝이 /daemon")
    func daemonProjectDirSuffix() {
        // 호스트 없는 테스트 번들이라 실제 daemon 디렉토리는 없지만 path 산출 형태는 검증.
        #expect(DaemonPaths.daemonProjectDir.hasSuffix("/daemon"))
    }

    @Test("nodeBinary / torBinary / sshdBinary 가 bin/ 아래")
    func binariesUnderBin() {
        #expect(DaemonPaths.nodeBinary.hasSuffix("/daemon/bin/node"))
        #expect(DaemonPaths.torBinary.hasSuffix("/daemon/bin/tor"))
        #expect(DaemonPaths.sshdBinary.hasSuffix("/daemon/bin/sshd"))
    }

    @Test("torDataDir 가 share/tor")
    func torDataDirSuffix() {
        #expect(DaemonPaths.torDataDir.hasSuffix("/daemon/share/tor"))
    }

    @Test("daemonEntry 는 [tsx, src/index.ts] 형태 — daemon 부팅 명령이 이걸 그대로 사용")
    func daemonEntryShape() {
        let entry = DaemonPaths.daemonEntry
        #expect(entry.count == 2)
        #expect(entry[0].hasSuffix("/node_modules/.bin/tsx"))
        #expect(entry[1].hasSuffix("/src/index.ts"))
    }
}
