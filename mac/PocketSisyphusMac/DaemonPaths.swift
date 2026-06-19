import Foundation

/// daemon 관련 파일 경로 — Mac 앱과 daemon이 같은 위치를 봄.
enum DaemonPaths {
    static var configDir: URL {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PocketSisyphus", isDirectory: true)
    }
    static var configFile: URL { configDir.appendingPathComponent("config.json") }
    /// daemon 이 listen 직후 기록하는 런타임 상태 (`{ port, endpointPort, pid }`).
    /// config.json 의 `port` 는 «선호» 포트일 뿐 — 점유 시 daemon 이 빈 포트로 폴백하므로
    /// 실제 바인딩 포트는 이 파일이 진실이다 (server.ts 의 listen 콜백이 매 부팅 덮어씀).
    static var runtimeFile: URL { configDir.appendingPathComponent("daemon-runtime.json") }
    static var onionHostnameFile: URL {
        configDir.appendingPathComponent("tor/hs/hostname")
    }

    /// daemon 이 «실제로» 바인딩한 HTTP 포트 — 로컬 API 호출(DaemonAPI/LocalDaemonClient)의
    /// 단일 진실. daemon-runtime.json 의 port 를 우선 읽고, 없으면(옛 daemon / 첫 부팅 전)
    /// config.json 의 선호 포트 → 기본 7777 순으로 폴백한다.
    static func boundDaemonPort() -> Int {
        if let data = try? Data(contentsOf: runtimeFile),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let port = obj["port"] as? Int, port > 0 {
            return port
        }
        if let data = try? Data(contentsOf: configFile),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let port = obj["port"] as? Int, port > 0 {
            return port
        }
        return 7777
    }
    static var pairQRFile: URL { configDir.appendingPathComponent("pair-qr.png") }
    static var torLogFile: URL { configDir.appendingPathComponent("tor/tor.log") }

    /// daemon 소스 위치 — 항상 `.app/Contents/Resources/daemon`.
    /// Debug/Release 둘 다 빌드 단계에서 daemon 디렉토리를 번들에 포함시킨다.
    /// 배포된 .app 에서는 워크스페이스 mac/daemon 경로가 존재하지 않으므로 번들 위치만 본다.
    static var daemonProjectDir: String {
        guard let resources = Bundle.main.resourcePath else {
            NSLog("[DaemonPaths] Bundle.main.resourcePath nil — 진단 불가")
            return ""
        }
        let bundled = "\(resources)/daemon"
        if !FileManager.default.fileExists(atPath: "\(bundled)/package.json") {
            NSLog("[DaemonPaths] daemon 번들 누락: \(bundled) — embed-daemon-binaries.sh + postCompileScript 확인")
        }
        return bundled
    }

    /// 번들된 Node.js (`Resources/daemon/bin/node`).
    /// embed-daemon-binaries.sh 가 공식 Node.js darwin-arm64 배포본을 daemon/bin/ 에 배치.
    /// 시스템 PATH 의 node 에 의존하지 않는다 — 받는 Mac 에 깔려 있다는 보장 없고, 깔려
    /// 있어도 버전 충돌 위험 (우리는 v25.4.0 에 결정적으로 박혀 있음).
    static var nodeBinary: String {
        "\(daemonProjectDir)/bin/node"
    }

    /// 번들된 tor (`Resources/daemon/bin/tor`).
    /// daemon TS 코드(tor/sidecar.ts) 가 POCKET_CLAUDE_TOR_BIN 환경변수를 읽도록 변경.
    /// Mac 앱이 spawn 할 때 이 경로를 env 로 넘긴다.
    static var torBinary: String {
        "\(daemonProjectDir)/bin/tor"
    }

    /// 번들된 OpenSSH portable sshd (`Resources/daemon/bin/sshd`).
    /// daemon TS 코드(ssh/server.ts) 가 POCKET_CLAUDE_SSHD_BIN 환경변수를 읽어 spawn.
    /// 듀얼 채널 모델의 SSH 서버 채널 — 직접 SSH (UPnP/IPv6) + Tor onion 22 포트 둘 다 같은 sshd.
    static var sshdBinary: String {
        "\(daemonProjectDir)/bin/sshd"
    }

    /// tor geoip 데이터 디렉토리 (`Resources/daemon/share/tor/`).
    /// torrc 의 GeoIPFile/GeoIPv6File 옵션으로 sidecar.ts 가 이 경로를 명시 지정.
    static var torDataDir: String {
        "\(daemonProjectDir)/share/tor"
    }

    /// 번들된 화면 캡처 + 입력 주입 헬퍼 (`Resources/daemon/bin/capture-helper`).
    /// daemon TS 코드(capture/sidecar.ts)가 POCKET_CLAUDE_CAPTURE_BIN 환경변수를 읽어 spawn.
    /// macOS 화면 기록(캡처) + 손쉬운 사용(입력 주입) TCC 권한이 필요하다 — Mac 앱 번들 기준 승인.
    static var captureBinary: String {
        "\(daemonProjectDir)/bin/capture-helper"
    }

    /// daemon entry path (실행될 TypeScript) — Release/Debug 모두 동일. 회수(reclaim) 로직이
    /// 이 절대경로를 marker 로 «우리 daemon 프로세스» 를 식별하므로 별도로 노출.
    static var daemonEntryPath: String {
        "\(daemonProjectDir)/src/index.ts"
    }

    /// node 인자 — `node --import tsx <entry>` 단일 프로세스로 TypeScript 실행.
    ///
    /// 과거엔 `node .bin/tsx <entry>` 였는데, tsx CLI 가 **별도 자식 node** 를 spawn 해
    /// 프로세스가 둘이 됐다(셔임 + 실제 daemon). Mac 앱이 추적하는 PID 는 셔임이라, 셔임만
    /// 죽고 실제 daemon 이 orphan 으로 살아남아 7777/7778 을 계속 잡는 «재실행 실패» 의
    /// 구조적 원인이었다. `--import tsx` 는 같은 프로세스에 TS 로더를 등록하므로 프로세스가
    /// 하나 — 추적 PID = 실제 daemon, SIGTERM 직통, ppid 기반 watchdog 도 신뢰 가능해진다.
    static var daemonEntry: [String] {
        ["--import", "tsx", daemonEntryPath]
    }
}
