import Foundation
import Security

/// 직접(IPv4/IPv6) SSH 채널의 host key fingerprint 를 영속 저장하는 TOFU(trust on first use) 장부.
///
/// ## 왜 필요한가
/// Tor onion 채널은 onion 주소 자체가 공개키 hash 라 신원이 cryptographic 하게 보장되지만,
/// 직접 채널(IPv4/IPv6)은 그 보호가 없어 적대적 LAN/Wi-Fi 에서 daemon 을 가장한 MITM 여지가
/// 있다. 이 장부가 첫 신뢰 시점의 host key fingerprint 를 박아 두고 이후 연결마다 대조한다.
///
/// ## 키 = onion 주소
/// 직접 endpoint 의 IPv4/IPv6 주소는 회전(rotate)하지만 sshd host key 는 한 Mac 에서 영구다.
/// 그래서 «호스트:포트» 가 아니라 그 Mac 의 onion 주소를 identity 로 쓴다 — IP 가 바뀌어도 같은
/// 신뢰 레코드를 재사용하고, 다른 Mac(다른 onion)과는 자연히 분리된다.
///
/// ## 동시성
/// host key 검증은 Citadel/NIO 의 event loop 스레드에서 일어나므로 이 store 는 MainActor 가
/// «아니다». Keychain 호출(Security framework)은 thread-safe 이고, read-modify-write(레코드
/// 한 건 갱신) 구간만 `NSLock` 으로 직렬화한다. happy eyeballs 가 같은 onion 으로 여러 직접
/// candidate 를 «동시에» 첫 연결할 때도 같은 host key → 같은 fingerprint 라 경합이 무해하다.
///
/// ## 저장 위치
/// Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). fingerprint 자체는 비밀이
/// 아니지만, 공격자가 장부를 임의로 덮어쓰면 악성 키를 신뢰시킬 수 있어 무결성을 위해 Keychain
/// 에 둔다 (EndpointCache·AuthStore 와 동일 정책).
final class KnownHostStore: @unchecked Sendable {

    private let service = "pe.wayne.pocketsisyphus"
    private let account = "known-hosts-tofu"
    private let lock = NSLock()

    init() {}

    /// 주어진 identity(onion)에 신뢰된 fingerprint. 없으면 nil(= 아직 첫 연결 전).
    func fingerprint(forIdentity identity: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return load()[identity]
    }

    /// fingerprint 를 identity 에 (재)기록. 이미 있으면 덮어쓴다 — pairing/endpoint 가 준
    /// 신뢰 fingerprint(anchor)로 검증을 통과한 경우 그 값이 권위 있으므로 stale 레코드를 갱신.
    func record(_ fingerprint: String, forIdentity identity: String) {
        lock.lock()
        defer { lock.unlock() }
        var map = load()
        guard map[identity] != fingerprint else { return }
        map[identity] = fingerprint
        save(map)
    }

    /// 전체 장부 삭제 (페어링 해제 등). identity 별 분리 덕에 필수는 아니지만 위생용.
    func clear() {
        lock.lock()
        defer { lock.unlock() }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Keychain (lock 보유 상태에서만 호출)

    private func load() -> [String: String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data,
              let map = try? JSONDecoder().decode([String: String].self, from: data) else {
            return [:]
        }
        return map
    }

    private func save(_ map: [String: String]) {
        let data = (try? JSONEncoder().encode(map)) ?? Data()
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
    }
}
