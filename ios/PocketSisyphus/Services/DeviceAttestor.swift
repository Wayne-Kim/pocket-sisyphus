import Foundation
import Security
import LocalAuthentication
import CryptoKit  // SecureEnclave.isAvailable

/// Secure Enclave 에 묶인 P-256 «기기 키» 관리 + 서명.
///
/// ## 왜 있나
/// 폰↔Mac daemon 인증은 원래 전부 QR 에 담긴 정적 비밀(SSH client priv + bearer token)에
/// 의존했다 — QR 사진 한 장이 유출되면 폰을 완전히 가장 가능. 이 키는 거기에 «추출 불가능한
/// 하드웨어 요소» 를 더한다: private key 는 Secure Enclave 밖으로 절대 안 나오고, 사용할 때
/// 마다 Face ID/Touch ID 로 게이팅된다. daemon 은 등록된 공개키로 challenge nonce 서명을
/// «오프라인» 검증하므로(Apple 인프라 무관), QR/토큰을 모두 탈취해도 유효 서명을 못 만든다.
///
/// ## 제약
/// Secure Enclave 는 256-bit NIST P-256(secp256r1) EC 키만 지원한다. 그래서 SSH 의
/// ed25519 키를 그대로 SE 로 옮기는 대신, SSH 채널 «위» 에 이 P-256 키로 challenge-response
/// 한 겹을 얹는 설계를 택했다 (CLAUDE 계획 참고).
enum DeviceAttestor {

    /// Keychain 에서 이 SE 키를 찾는 application tag. 앱 재설치에도 keychain 항목이 살아남아
    /// 키가 보존된다 (기기 교체/복원 시에만 소실 — 그때는 재페어링으로 복구).
    private static let tag = "pe.wayne.pocketsisyphus.attest".data(using: .utf8)!

    enum AttestorError: LocalizedError {
        case secureEnclaveUnavailable
        case keyCreateFailed(String)
        case publicKeyExportFailed
        case noKey
        /// 서명 실패 — 바탕 CFError 를 NSError 로 «보존» 한다. 생체 프롬프트가 SecKeyCreateSignature
        /// 안에서 뜨므로, 취소·lockout·미지원 같은 LAError 분기는 호출부(LockView)가 이 NSError 의
        /// 도메인/코드를 읽어야 한다 — 문자열로 납작하게 만들면 그 정보가 사라진다.
        case signFailed(NSError)

        var errorDescription: String? {
            switch self {
            case .secureEnclaveUnavailable:
                return String(localized: "이 기기는 Secure Enclave 를 지원하지 않습니다")
            case .keyCreateFailed(let m):
                return String(localized: "기기 인증 키 생성 실패: \(m)")
            case .publicKeyExportFailed:
                return String(localized: "기기 인증 공개키를 읽을 수 없습니다")
            case .noKey:
                return String(localized: "이 기기의 인증 키가 없습니다")
            case .signFailed(let e):
                let detail = e.localizedDescription
                return String(localized: "기기 인증 서명 실패: \(detail)")
            }
        }
    }

    /// 이 기기에 Secure Enclave 가 있는지. 시뮬레이터엔 보통 없으므로, 없으면 기기 인증을
    /// 통째로 비활성(soft)해 페어링/사용을 막지 않는다. 실기기는 iPhone 5s 이후 전부 보유.
    static var isAvailable: Bool { SecureEnclave.isAvailable }

    /// 이 기기에 SE 키가 이미 있는지. (참조 조회만 — 생체 프롬프트 안 뜬다, 서명 시에만 뜸.)
    static func hasKey() -> Bool {
        (try? loadPrivateKey(context: nil)) != nil
    }

    /// SE 키가 없으면 생성하고, 공개키를 base64(X9.63 uncompressed 65B) 로 반환.
    /// daemon `/api/attest/register` 의 publicKey 필드에 그대로 들어간다.
    @discardableResult
    static func enrollIfNeeded() throws -> String {
        if let existing = try loadPrivateKey(context: nil) {
            return try publicKeyBase64(from: existing)
        }
        let key = try createKey()
        return try publicKeyBase64(from: key)
    }

    /// 현재 SE 키의 공개키 base64. 키가 없으면 throw.
    static func publicKeyBase64() throws -> String {
        guard let key = try loadPrivateKey(context: nil) else { throw AttestorError.noKey }
        return try publicKeyBase64(from: key)
    }

    /// 이 기기 SE 공개키의 표시용 지문 ("SHA256:<base64-no-padding>"). 키가 없으면 nil.
    ///
    /// daemon `attestKeyFingerprint()` 와 «같은 포맷» 으로 맞춘다 — raw 공개키 바이트(X9.63
    /// 65B)의 SHA-256 을 base64(패딩 제거)한 뒤 "SHA256:" prefix. 페어링 시 daemon `/status`
    /// 의 fingerprint 와 1:1 비교해 «이미 다른 기기가 등록됨» 을 생체 프롬프트 전에 가려낸다.
    static func publicKeyFingerprint() -> String? {
        guard let pubBase64 = try? publicKeyBase64(),
              let raw = Data(base64Encoded: pubBase64) else { return nil }
        let digest = SHA256.hash(data: raw)
        let b64 = Data(digest).base64EncodedString().replacingOccurrences(of: "=", with: "")
        return "SHA256:\(b64)"
    }

    /// 이 기기의 생체 인증 종류 (Face ID / Touch ID / Optic ID / 없음).
    /// 잠금 화면 카피를 기기에 맞게(«Face ID» vs «Touch ID») 보여 주기 위함 — iOS 17 최소
    /// 지원이라 iPhone SE(2·3세대) 같은 Touch ID 전용 기기도 대상에 든다.
    static var biometryType: LABiometryType {
        let ctx = LAContext()
        // canEvaluatePolicy 를 한 번 호출해야 biometryType 이 채워진다(미호출 시 .none).
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return ctx.biometryType
    }

    /// 사용자 노출용 생체 인증 이름. 기기에 생체가 없거나 미정이면 일반 표현.
    static var biometryDisplayName: String {
        switch biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return String(localized: "생체 인증")
        }
    }

    /// `message` 를 SE 키로 ECDSA-P256-SHA256 서명한다 (ASN.1 DER 출력).
    ///
    /// daemon 측 `crypto.verify("sha256", …, {dsaEncoding:"der"})` 와 1:1 호환
    /// (`.ecdsaSignatureMessageX962SHA256` = 메시지를 SHA-256 한 뒤 DER ECDSA).
    ///
    /// `context` 의 `touchIDAuthenticationAllowableReuseDuration` 덕에, 한 인증 사이클에서
    /// 같은 context 로 연속 서명하면(등록 서명 + nonce 서명) Face ID 는 한 번만 뜬다.
    static func sign(_ message: Data, context: LAContext) throws -> Data {
        guard let priv = try loadPrivateKey(context: context) else { throw AttestorError.noKey }
        var error: Unmanaged<CFError>?
        guard
            let sig = SecKeyCreateSignature(
                priv, .ecdsaSignatureMessageX962SHA256, message as CFData, &error)
        else {
            // CFError 를 NSError 로 보존 — 호출부가 LAError(생체 취소/lockout/미지원)를 분기한다.
            // (LAContext 바인딩 경로는 보통 LAErrorDomain, 일부 OSStatus 로 올라온다.)
            let cf: CFError? = error?.takeRetainedValue()
            let ns: NSError = (cf as Error?).map { $0 as NSError }
                ?? NSError(domain: NSOSStatusErrorDomain, code: Int(errSecAuthFailed))
            throw AttestorError.signFailed(ns)
        }
        return sig as Data
    }

    // MARK: - private

    private static func createKey() throws -> SecKey {
        guard SecureEnclave.isAvailable else { throw AttestorError.secureEnclaveUnavailable }
        var acError: Unmanaged<CFError>?
        // 사용 시 생체(Face ID/Touch ID) 필요 + 생체 «등록 변경 시 자동 무효화»(biometryCurrentSet).
        // WhenUnlockedThisDeviceOnly: 기기 잠금 해제 상태에서만, 백업/다른 기기로 이전 불가.
        guard
            let access = SecAccessControlCreateWithFlags(
                kCFAllocatorDefault,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                [.privateKeyUsage, .biometryCurrentSet],
                &acError)
        else {
            throw AttestorError.keyCreateFailed(cfErrorString(acError))
        }
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag,
                kSecAttrAccessControl as String: access,
            ],
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
            throw AttestorError.keyCreateFailed(cfErrorString(error))
        }
        return key
    }

    /// SE private key 참조 조회. `context` 를 주면 그 LAContext 인증 컨텍스트로 묶인다
    /// (서명 시 그 context 의 reuse-duration 정책 적용). 키 없으면 nil.
    private static func loadPrivateKey(context: LAContext?) throws -> SecKey? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
        ]
        if let context {
            query[kSecUseAuthenticationContext as String] = context
        }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let item else { return nil }
        // SecItemCopyMatching 가 kSecReturnRef 면 SecKey 를 돌려준다.
        return (item as! SecKey)
    }

    private static func publicKeyBase64(from key: SecKey) throws -> String {
        guard let pub = SecKeyCopyPublicKey(key) else { throw AttestorError.publicKeyExportFailed }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(pub, &error) as Data? else {
            throw AttestorError.publicKeyExportFailed
        }
        // EC 공개키의 external representation = X9.63 `0x04 || X(32) || Y(32)` (65B).
        return data.base64EncodedString()
    }

    private static func cfErrorString(_ error: Unmanaged<CFError>?) -> String {
        guard let error else { return "unknown" }
        return (error.takeRetainedValue() as Error).localizedDescription
    }
}
