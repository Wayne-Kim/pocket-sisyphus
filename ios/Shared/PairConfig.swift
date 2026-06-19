import Foundation

/// 페어링 정보 — 듀얼 채널 모델 v=3 페이로드.
///
/// 구성:
///  - `onion` + `onionAuth`: Tor 회로 빌드 → /endpoint 받기 + SSH-over-Tor fallback.
///  - `endpointToken`: Tor onion 위 /endpoint Bearer.
///  - `daemonToken`: SSH local forward 위 daemon /api/* Bearer.
///  - `sshHostKeyFingerprint`: SSH 연결 시 host key 검증 ("SHA256:...").
///  - `sshClientPriv`: 페어링 발급된 ed25519 priv (PKCS8 PEM, base64 encoded).
///  - `sshUser`: sshd 가 받아들이는 사용자명 (macOS 현재 user).
///
/// `httpBase` / `wsBase` 같은 URL helper 는 더 이상 PairConfig 가 제공하지 않는다 — 데이터 plane URL
/// 은 ConnectionManager 가 happy eyeballs 로 채택한 endpoint 기반 SSH local forward 포트에서 결정.
struct PairConfig: Codable, Equatable {
    let onion: String                  // 예: "vcsbjwx5...byd.onion"
    let onionAuth: String              // base32 x25519 priv (RFC4648, no padding, uppercase)
    let endpointToken: String          // /endpoint Bearer (Tor onion 노출 채널)
    let daemonToken: String            // daemon /api/* Bearer (SSH 채널 안에서)
    let sshHostKeyFingerprint: String  // "SHA256:..." — 표시/진단용
    // sshd host 공개키 한 줄 ("ssh-ed25519 AAAA... comment"). SSH host key 를 .trustedKeys 로
    // 핀하는 데 쓴다. Optional — 구버전 페어링(이 필드 없음)은 nil 로 디코드되어 TOFU fallback.
    let sshHostKey: String?
    let sshClientPriv: String          // ed25519 priv PKCS8 PEM, base64 encoded
    let sshUser: String                // sshd AllowUsers 의 값 (macOS 현재 user)
    let name: String                   // Mac 별명 (예: "Wayne's Mac")
    let pairedAt: Date
    // LAN 전용(사설망 직결) 모드용 — Tor 없이도 같은 LAN 의 Mac 에 직행할 수 있게 페어링 QR 로
    // 함께 받는다. `lanHost` = mDNS `<host>.local`(DHCP 로 사설 IP 가 바뀌어도 추종). `sshPort`
    // = 직접 SSH 포트. `daemonPort` = SSH local forward 목적지(daemon HTTP). 구버전 QR 엔 없어
    // Optional — LAN 전용 모드를 콜드(캐시 없이) 부트스트랩하려면 이 값들이 필요하다.
    let lanHost: String?
    let sshPort: UInt16?
    let daemonPort: UInt16?
}

/// QR 코드 페이로드 — daemon 의 tor/pairing.ts buildPairingPayload 와 짝.
///
/// v=3 부터 SSH 필드 (host fingerprint + client priv + user) 필수. v<3 페이로드는 SSH 인증 불가
/// → 페어링 거부 후 사용자에게 "Mac 앱 업데이트 후 재페어링" 안내.
struct PairQRPayload: Codable {
    let v: Int
    let onion: String
    let onion_auth: String?
    let endpoint_token: String?
    let daemon_token: String?
    let ssh_host_key_fingerprint: String?
    let ssh_host_key: String?
    let ssh_client_priv: String?
    let ssh_user: String?
    let name: String?
    // LAN 전용 모드 부트스트랩용 (daemon pairing.ts 와 짝). 구버전 QR 엔 없어 Optional.
    let lan_host: String?
    let ssh_port: Int?
    let daemon_port: Int?
}
