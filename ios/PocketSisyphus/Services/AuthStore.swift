import Foundation
import Security

/// PairConfig 를 Keychain 에 안전 저장.
///
/// 듀얼 채널 모델 전환 후 App Group mirror (SharedAuth) 는 제거됨 — 메인 앱이 단독으로
/// Tor + SSH 운용하므로 익스텐션과 공유할 데이터가 없음.
@MainActor
final class AuthStore: ObservableObject {
    @Published private(set) var config: PairConfig?

    /// 마지막 페어링 실패 사유(이미 로컬라이즈된 문자열). PairView 의 @State 가 아니라 여기
    /// 둔다 — 페어링 흐름에서 `save(cfg)` 가 먼저 일어나 AppRoot 가 PairView 를 잠깐 헐어내고,
    /// 실패 시 `clear()` 로 다시 그릴 때 «새» PairView 인스턴스라 @State error 가 날아간다.
    /// 그러면 «이미 다른 기기가 연결됨» 같은 안내가 사용자에게 안 보인다. 스토어에 담아 두면
    /// 새 PairView 가 떠도 그대로 읽어 표시할 수 있다. 새 스캔 시작 시 비운다.
    @Published var lastPairingError: String?

    private let service = "pe.wayne.pocketsisyphus"
    private let account = "pair-config"

    init() {
        self.config = loadFromKeychain()
    }

    func save(_ cfg: PairConfig) {
        let data = (try? JSONEncoder().encode(cfg)) ?? Data()
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
        self.config = cfg
    }

    func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        self.config = nil
    }

    private func loadFromKeychain() -> PairConfig? {
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
        return try? JSONDecoder().decode(PairConfig.self, from: data)
    }
}
