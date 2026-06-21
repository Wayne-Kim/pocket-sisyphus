import Foundation

// MARK: - REST 클라이언트

/// 같은 머신의 daemon 에 직결하는 REST + WS 클라이언트. iOS 의 ApiClient/WSClient 와
/// 시그니처가 거의 동일하지만 SOCKS5 proxy 설정이 빠져 있고, Bearer token 은
/// `~/Library/Application Support/PocketSisyphus/config.json` 의 평문 token 을 직접
/// 읽는다 (별도 페어링 절차 X — daemon 부팅 시 우리가 직접 만든 token).
///
/// daemon 의 `requireClientVersion` 미들웨어를 통과하려면 X-Client-Version 헤더가 필요
/// — Mac 앱의 marketing version (CFBundleShortVersionString) 을 그대로 박는다. Mac 앱과
/// daemon 이 같은 .app 안에 박혀 같이 배포되므로 버전 mismatch 는 사실상 없다.
@MainActor
final class LocalDaemonClient {
    enum ClientError: LocalizedError {
        case tokenUnavailable
        case http(status: Int, body: String)
        case decode(String)
        case transport(Error)

        var errorDescription: String? {
            switch self {
            case .tokenUnavailable:
                return String(localized: "daemon 토큰을 읽지 못했습니다 (config.json 확인)")
            case .http(let s, let b):
                let snippet = String(b.prefix(200))
                return String(localized: "HTTP \(s): \(snippet)")
            case .decode(let m):
                return String(localized: "응답 파싱 실패: \(m)")
            case .transport(let e):
                return String(localized: "통신 실패: \(e.localizedDescription)")
            }
        }
    }

    private static let urlSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 30
        cfg.httpAdditionalHeaders = ["Accept-Encoding": "gzip, deflate"]
        return URLSession(configuration: cfg)
    }()

    private static var clientVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0"
    }

    /// config.json 에서 token + port + localAdminSecret 추출. daemon 이 아직 init 전이면 nil.
    /// port 키는 옛 빌드 호환을 위해 optional — 누락 시 daemon 기본값 7777.
    /// localAdminSecret 은 폰 등록 후 attest 게이트를 우회하는 로컬 운영자 비밀(없을 수 있음 —
    /// daemon 첫 부팅 전이거나 옛 daemon. 그땐 X-PS-Local 헤더를 생략한다).
    static func loadConfig() -> (token: String, port: Int, localAdminSecret: String?)? {
        guard let data = try? Data(contentsOf: DaemonPaths.configFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = obj["token"] as? String,
              !token.isEmpty
        else {
            return nil
        }
        let port = (obj["port"] as? Int) ?? 7777
        let secret = obj["localAdminSecret"] as? String
        return (token, port, secret)
    }

    /// 사용자가 지정한 선호 daemon 포트(없으면 기본 7777). loadConfig 의 port 와 동일하나
    /// daemon 미init(=config 없음)이어도 기본값을 돌려줘 설정 UI 가 항상 값을 보여줄 수 있게.
    static let defaultDaemonPort = 7777
    static func configuredPort() -> Int { loadConfig()?.port ?? defaultDaemonPort }

    /// config.json 의 `port` 를 읽기-수정-쓰기로 변경한다. token / notify 등 다른 키는 그대로
    /// 보존(전체 객체를 읽어 port 만 교체). 0600 권한 유지. daemon 이 다음 부팅 때 이 값을
    /// 선호 포트로 사용하고, 점유 시 자동으로 빈 포트로 폴백한다.
    /// config.json 이 없으면(daemon 한 번도 init 안 됨) throw — 호출부가 «먼저 시작» 안내.
    static func setConfiguredPort(_ port: Int) throws {
        let url = DaemonPaths.configFile
        let data = try Data(contentsOf: url)
        guard var obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ClientError.decode("config.json")
        }
        obj["port"] = port
        let out = try JSONSerialization.data(
            withJSONObject: obj,
            options: [.prettyPrinted, .sortedKeys],
        )
        try out.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: url.path,
        )
    }

    /// 사용자가 지정한 SSH 포트(없으면 기본 22022). config.json 의 `sshPort` 키.
    static let defaultSshPort = 22022
    static func configuredSshPort() -> Int {
        guard let data = try? Data(contentsOf: DaemonPaths.configFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return defaultSshPort }
        return (obj["sshPort"] as? Int) ?? defaultSshPort
    }

    /// LAN 전용(사설망 직결) 모드 여부 — config.json `lanOnly` 키. 기본 false.
    /// 켜지면 daemon `/endpoint` 가 공인 IPv4/IPv6·onion 을 빼고 direct_lan 만 광고한다.
    static func configuredLanOnly() -> Bool {
        guard let data = try? Data(contentsOf: DaemonPaths.configFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return (obj["lanOnly"] as? Bool) ?? false
    }

    /// config.json 의 `lanOnly` 를 읽기-수정-쓰기로 변경. 다른 키(token/port/notify)는 보존.
    /// config.json 이 없으면(daemon 한 번도 init 안 됨) throw — 호출부가 «먼저 시작» 안내.
    static func setConfiguredLanOnly(_ enabled: Bool) throws {
        let url = DaemonPaths.configFile
        let data = try Data(contentsOf: url)
        guard var obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ClientError.decode("config.json")
        }
        obj["lanOnly"] = enabled
        let out = try JSONSerialization.data(
            withJSONObject: obj,
            options: [.prettyPrinted, .sortedKeys],
        )
        try out.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: url.path,
        )
    }

    /// config.json 의 `sshPort` 를 읽기-수정-쓰기로 변경. 다른 키(token/port/notify)는 보존.
    /// 데몬 포트와 달리 SSH 포트는 점유 시 자동 폴백하지 않으므로(외부 노출 채널이 가리켜야 함),
    /// 사용자가 직접 빈 포트를 골라야 한다. config.json 이 없으면 throw.
    static func setConfiguredSshPort(_ port: Int) throws {
        let url = DaemonPaths.configFile
        let data = try Data(contentsOf: url)
        guard var obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ClientError.decode("config.json")
        }
        obj["sshPort"] = port
        let out = try JSONSerialization.data(
            withJSONObject: obj,
            options: [.prettyPrinted, .sortedKeys],
        )
        try out.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: url.path,
        )
    }

    static func httpBase(port: Int) -> URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    private func authedRequest(method: String, path: String, body: Data? = nil) throws -> URLRequest {
        guard let cfg = Self.loadConfig() else { throw ClientError.tokenUnavailable }
        // cfg.port(선호 포트)가 아니라 실제 바인딩 포트 — 선호 포트 점유로 daemon 이
        // 빈 포트로 폴백한 환경에서도 로컬 호출이 따라가도록.
        guard let url = URL(string: path, relativeTo: Self.httpBase(port: DaemonPaths.boundDaemonPort())) else {
            throw ClientError.tokenUnavailable
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(cfg.token)", forHTTPHeaderField: "Authorization")
        req.setValue(Self.clientVersion, forHTTPHeaderField: "X-Client-Version")
        // 로컬 운영자 우회 — 폰 등록 후에도 Mac 앱 자기 호출이 attest 게이트에 막히지 않게.
        if let secret = cfg.localAdminSecret {
            req.setValue(secret, forHTTPHeaderField: "X-PS-Local")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        return req
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: Encodable? = nil) async throws -> T {
        let bodyData: Data? = try body.map { try JSONEncoder().encode($0) }
        let req = try authedRequest(method: method, path: path, body: bodyData)
        do {
            let (data, resp) = try await Self.urlSession.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                throw ClientError.http(status: -1, body: "non-http response")
            }
            guard (200..<300).contains(http.statusCode) else {
                throw ClientError.http(
                    status: http.statusCode,
                    body: String(data: data, encoding: .utf8) ?? "",
                )
            }
            return try JSONDecoder().decode(T.self, from: data)
        } catch let e as ClientError {
            throw e
        } catch let e as DecodingError {
            throw ClientError.decode("\(e)")
        } catch {
            throw ClientError.transport(error)
        }
    }

    // MARK: - Admin

    /// `NetworkChangeMonitor` 가 primary IPv4 변경을 감지했을 때 호출. daemon 측이 Tor 에
    /// SIGHUP 을 보내 introduction point 재선정 + descriptor 재publish 를 강제한다.
    /// daemon 의 30s 쿨다운이 폭주를 막아주므로 호출 빈도 걱정 X. 실패 throw 무시 OK.
    func kickReconnect() async throws {
        struct Resp: Decodable { let ok: Bool; let result: String? }
        let _: Resp = try await send("POST", "/api/admin/network-changed")
    }

    /// 사일런트(무클릭) 업데이트 경로의 결과를 daemon 에 보고. iOS 가 `/api/version` 의
    /// `lastUpdate` 로 «이미 최신 / 실패» 를 사용자에게 보여줄 수 있게 한다.
    ///
    /// 설치 성공은 relaunch 로 프로세스가 교체되므로 여기서 보고하지 않는다 — 재부팅된
    /// daemon 의 버전 ↑ 가 iOS 측 «완료» 신호다. 따라서 state 는 "no_update" / "error" 만.
    func reportUpdateStatus(state: String, message: String?) async throws {
        struct OK: Decodable { let ok: Bool? }
        struct Body: Encodable { let state: String; let message: String? }
        let _: OK = try await send(
            "POST",
            "/api/admin/update-status",
            body: Body(state: state, message: message),
        )
    }
}
