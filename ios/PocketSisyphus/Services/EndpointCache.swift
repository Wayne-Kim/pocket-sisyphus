import Foundation
import Security

/// daemon `/endpoint` 응답을 Keychain 에 캐시. 다음 포그라운드 진입 시 Tor 안 띄우고 SSH 직행.
///
/// ## 만료 정책
/// TTL 자체로 강제 갱신하지 않는다. 만료된 endpoint 라도 그대로 SSH 시도 → 실패하면
/// 그때 Tor 띄워서 `/endpoint` 다시 받기. 즉 **연결 실패가 유일한 갱신 트리거**.
///
/// 가정 인터넷의 IPv4 변경은 보통 일/주 단위라 ttl 만 보고 미리 갱신하면 Tor 트래픽
/// 낭비. 실패 시점에만 갱신 = 평소엔 0번, 진짜 IP 바뀐 시점에만 1번.
///
/// ## 저장 위치
/// Keychain (민감도는 낮으나 IPv4 주소 + onion 매핑이 폰 분실 시 노출되면 사용자 식별
/// 자료가 될 수 있음 — 일관성 위해 Keychain).
struct EndpointEntry: Codable, Equatable {
    enum EndpointType: String, Codable {
        // 사설망 직결(LAN 전용) — 같은 LAN 의 사설/링크로컬·mDNS 주소. priority 0 = 최우선.
        // 패킷이 사설망을 벗어나지 않는다. LAN 전용 모드에선 «유일하게» 허용되는 채널.
        case directLan = "direct_lan"
        case directIPv6 = "direct_ipv6"
        case directIPv4 = "direct_ipv4"
        case torOnion = "tor_onion"
    }
    let type: EndpointType
    let host: String
    let port: UInt16
    let priority: Int
}

struct EndpointConfig: Codable, Equatable {
    let v: Int
    let endpoints: [EndpointEntry]
    let sshHostKeyFingerprint: String
    let sshUser: String
    let daemonLocalPort: UInt16
    let issuedAt: Date
    let ipFetchedAt: Date?
    let ttlSec: Int

    /// daemon `/endpoint` JSON 응답 매핑. 서버 키는 snake_case.
    enum CodingKeys: String, CodingKey {
        case v
        case endpoints
        case sshHostKeyFingerprint = "ssh_host_key_fingerprint"
        case sshUser = "ssh_user"
        case daemonLocalPort = "daemon_local_port"
        case issuedAt = "issued_at"
        case ipFetchedAt = "ip_fetched_at"
        case ttlSec = "ttl_sec"
    }
}

@MainActor
final class EndpointCache: ObservableObject {
    @Published private(set) var cached: EndpointConfig?

    private let service = "pe.wayne.pocketsisyphus"
    private let account = "endpoint-cache"

    init() {
        self.cached = loadFromKeychain()
    }

    func save(_ cfg: EndpointConfig) {
        let data = (try? jsonEncoder().encode(cfg)) ?? Data()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        let add: [String: Any] = query.merging([
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ], uniquingKeysWith: { _, b in b })
        SecItemAdd(add as CFDictionary, nil)
        self.cached = cfg
    }

    func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        self.cached = nil
    }

    private func loadFromKeychain() -> EndpointConfig? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? jsonDecoder().decode(EndpointConfig.self, from: data)
    }

    private func jsonEncoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }

    private func jsonDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
